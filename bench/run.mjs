#!/usr/bin/env node
// Benchmark: apply a rule file to real public repositories and type-check them before and after.
//
//   node bench/run.mjs --rules bench/mux-14-to-15/rules.json --repos repos.json --work <scratch dir>
//     [--old @mux/mux-node@14.1.1] [--new @mux/mux-node@15.5.0,@mux/ts@15.5.0] [--limit 20]
//
// repos.json is a list of { repo: "owner/name", package?: "path/package.json" }.
// The repositories are untrusted. They are cloned shallowly, parsed and type-checked, and nothing in
// them is ever installed or run. Only the SDK packages named in --old and --new are installed, once,
// into <work>/repos/node_modules, which every clone resolves through.
//
// Three type-checks per repository, compared by file, line and error code:
//   A  original code with the old SDK   (baseline, its errors are ignored)
//   B  original code with the new SDK   (what upgrading without migrating breaks)
//   C  migrated code with the new SDK   (what is still broken after apimigrate)
// The new SDK is every package in --new, so a renamed package resolves under both names. Whether the
// migrated package.json actually declares each SDK package the migrated code imports is checked
// separately, file by file, because the shared node_modules cannot show it.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '..', 'bin', 'apimigrate.js');
const TSC = join(HERE, '..', 'node_modules', 'typescript', 'lib', 'tsc.js');
const CODE = /\.[cm]?[jt]sx?$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.apimigrate']);

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, ...opts });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function codeFiles(dir, root = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink() || SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) codeFiles(full, root, acc);
    else if (e.isFile() && CODE.test(e.name) && statSync(full).size < 2 * 1024 * 1024) acc.push(relative(root, full));
  }
  return acc;
}

// Installs SDK packages into one node_modules that every clone under dir resolves through.
function installSdk(dir, specs) {
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bench-sdk', private: true }) + '\n');
  const r = sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', ...specs], { cwd: dir });
  if (r.code !== 0) throw new Error(`npm install ${specs.join(' ')} failed:\n${r.err}`);
}

// Type-checks the given files of one tree and returns its diagnostics keyed by file, line and code.
function typecheck(tree, files, label) {
  const config = join(tree, '..', `tsconfig.${label}.json`);
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      noEmit: true, allowJs: true, checkJs: true, skipLibCheck: true, strict: false, jsx: 'preserve',
      target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', lib: ['ESNext', 'DOM'], types: [],
      resolveJsonModule: true, allowImportingTsExtensions: true, noUnusedLocals: false,
    },
    files: files.map((f) => join(tree, f)),
  }, null, 1));
  const r = sh(process.execPath, [TSC, '-p', config, '--pretty', 'false']);
  const diags = new Map();
  for (const line of r.out.split('\n')) {
    const m = line.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/);
    if (!m) continue;
    const file = relative(tree, resolve(m[1]));
    if (file.startsWith('..')) continue;
    diags.set(`${file}:${m[2]}:${m[3]}`, { file, line: Number(m[2]), code: m[3], message: m[4] });
  }
  return diags;
}

const minus = (a, b) => [...a].filter(([k]) => !b.has(k)).map(([, v]) => v);
const IMPORT = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)['"]((?:@[^'"/]+\/)?[^'"/]+)(?:\/[^'"]*)?['"]/g;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Files that import one of the SDK packages without the nearest package.json declaring it.
function undeclaredImports(tree, files, names) {
  const declared = (file, name) => {
    for (let dir = dirname(join(tree, file)); dir.startsWith(tree); dir = dirname(dir)) {
      if (!existsSync(join(dir, 'package.json'))) continue;
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        return DEP_FIELDS.some((f) => pkg[f]?.[name] !== undefined);
      } catch { return false; }
    }
    return false;
  };
  return files.filter((f) => [...readFileSync(join(tree, f), 'utf8').matchAll(IMPORT)].some((m) => names.includes(m[1]) && !declared(f, m[1])));
}

function main() {
  const f = flags(process.argv.slice(2));
  const work = resolve(f.work);
  const reposDir = join(work, 'repos');
  mkdirSync(reposDir, { recursive: true });
  const oldSdk = (f.old ?? '@mux/mux-node@14.1.1').split(',');
  const newSdk = (f.new ?? '@mux/mux-node@15.5.0,@mux/ts@15.5.0').split(',');
  const list = JSON.parse(readFileSync(f.repos, 'utf8')).slice(0, Number(f.limit ?? 1000));
  const pkgName = JSON.parse(readFileSync(f.rules, 'utf8')).package;
  const sdkNames = [...new Set([pkgName, ...newSdk.map((s) => s.replace(/(?!^)@[^@]*$/, ''))])];

  // Publisher side: a throwaway key signs the rule file, so apply runs the normal trust checks.
  const keys = join(work, 'keys');
  if (!existsSync(join(keys, 'apimigrate-keys.json'))) sh(process.execPath, [TOOL, 'keygen', '--out', keys]);
  const signed = join(work, 'rules.signed.json');
  cpSync(f.rules, signed);
  const s = sh(process.execPath, [TOOL, 'sign', signed, '--key', join(keys, 'apimigrate-private.pem')]);
  if (s.code !== 0) throw new Error(s.err);

  const results = [];
  for (const entry of list) {
    const slug = entry.repo.replace('/', '__');
    const dir = join(reposDir, slug);
    const base = join(dir, 'base');
    const migrated = join(dir, 'migrated');
    const row = { repo: entry.repo, version: entry.version ?? null };
    results.push(row);
    if (!existsSync(base)) {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      const c = sh('git', ['clone', '--quiet', '--depth', '1', `https://github.com/${entry.repo}.git`, base], { env });
      if (c.code !== 0) { row.error = 'clone failed'; continue; }
      // A pinned commit makes the run repeatable after the repository moves on.
      if (entry.commit && sh('git', ['-C', base, 'rev-parse', 'HEAD']).out.trim() !== entry.commit) {
        const fetched = sh('git', ['-C', base, 'fetch', '--quiet', '--depth', '1', 'origin', entry.commit], { env });
        if (fetched.code !== 0 || sh('git', ['-C', base, 'checkout', '--quiet', entry.commit]).code !== 0) { row.error = 'pinned commit unavailable'; continue; }
      }
    }
    row.commit = sh('git', ['-C', base, 'rev-parse', 'HEAD']).out.trim();
    const files = codeFiles(base);
    row.muxFiles = files.filter((p) => readFileSync(join(base, p), 'utf8').includes(pkgName));
    if (!row.muxFiles.length) { row.error = 'no file imports the package'; continue; }

    rmSync(migrated, { recursive: true, force: true });
    cpSync(base, migrated, { recursive: true });
    const started = Date.now();
    const a = sh(process.execPath, [TOOL, 'apply', '--rules', signed, '--keys', join(keys, 'apimigrate-keys.json'), '--root', migrated]);
    row.applyMs = Date.now() - started;
    row.applyExit = a.code;
    const evidencePath = join(migrated, '.apimigrate', 'evidence.json');
    if (!existsSync(evidencePath)) { row.error = `apply wrote no evidence: ${(a.err || a.out).trim().split('\n')[0]}`; continue; }
    const ev = JSON.parse(readFileSync(evidencePath, 'utf8'));
    row.changed = ev.callSites.length;
    row.changedByRule = ev.callSites.reduce((m, c) => ({ ...m, [c.ruleId]: (m[c.ruleId] ?? 0) + 1 }), {});
    row.unresolved = ev.unresolved;
    row.skipped = ev.skipped;
    row.gate = ev.gate.ok;
    row.filesChanged = ev.files.length;
    const leftover = new RegExp(`['"]${escape(pkgName)}(/[^'"]*)?['"]`);
    const migratedFiles = codeFiles(migrated);
    row.leftoverImports = migratedFiles.filter((p) => leftover.test(readFileSync(join(migrated, p), 'utf8'))).length;
    row.undeclaredImports = undeclaredImports(migrated, migratedFiles, sdkNames);
    row.manifestsChanged = ev.files.filter((f) => /(^|\/)package\.json$/.test(f.path)).map((f) => f.path);
    row.typecheckFiles = row.muxFiles;
  }

  const checkable = results.filter((r) => !r.error);
  const treeOf = (r, which) => join(reposDir, r.repo.replace('/', '__'), which);
  installSdk(reposDir, oldSdk);
  for (const r of checkable) r.A = typecheck(treeOf(r, 'base'), r.typecheckFiles, 'A');
  installSdk(reposDir, newSdk);
  for (const r of checkable) {
    r.B = typecheck(treeOf(r, 'base'), r.typecheckFiles, 'B');
    r.C = typecheck(treeOf(r, 'migrated'), r.typecheckFiles, 'C');
    // The baseline must actually see the SDK, or a clean result means nothing.
    r.sdkResolvedInBaseline = ![...r.A.values()].some((d) => d.code === 'TS2307' && d.message.includes(`'${pkgName}'`));
    r.brokenByUpgrade = minus(r.B, r.A);
    r.stillBroken = minus(r.C, r.A);
    r.fixed = r.brokenByUpgrade.filter((d) => !r.C.has(`${d.file}:${d.line}:${d.code}`)).length;
    r.newFromMigration = minus(r.C, r.B);
    r.baselineErrors = r.A.size;
    delete r.A; delete r.B; delete r.C; delete r.typecheckFiles;
  }

  const out = join(work, 'results.json');
  writeFileSync(out, JSON.stringify({ rules: f.rules, oldSdk, newSdk, ranAt: new Date().toISOString(), results }, null, 1) + '\n');
  console.log(`wrote ${out}`);
  for (const r of results) {
    if (r.error) { console.log(`${r.repo}: ${r.error}`); continue; }
    console.log(`${r.repo}: changed ${r.changed} sites in ${r.filesChanged} files, ${r.unresolved.length} queued, gate ${r.gate ? 'ok' : 'FAILED'}, upgrade breaks ${r.brokenByUpgrade.length}, still broken ${r.stillBroken.length}, migration added ${r.newFromMigration.length}`);
  }
}

main();
