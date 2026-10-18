import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../src/cli.js';
import { checkHead } from '../src/evidence.js';
import { installDependencies, installTargets } from '../src/install.js';
import { changedPaths, prBody } from '../src/prbody.js';
import { openWatchPullRequests } from '../src/watchpr.js';

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'install-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}
async function cli(argv) {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const npm = (cwd, ...args) => {
  const r = spawnSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stderr);
};
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim().replace(/\r\n/g, '\n');
};

test('installs happen where the lockfile is, with the package manager it names, and never run install scripts', () => {
  const dir = tree({
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'package-lock.json': '{}',
    'packages/web/package.json': '{}',
    'tools/pnpm/package.json': '{}', 'tools/pnpm/pnpm-lock.yaml': '',
    'tools/yarn1/package.json': '{}', 'tools/yarn1/yarn.lock': '',
    'tools/berry/package.json': '{}', 'tools/berry/yarn.lock': '', 'tools/berry/.yarnrc.yml': '',
    'tools/bun/package.json': '{}', 'tools/bun/bun.lock': '',
  });
  const targets = installTargets(dir, ['packages/web/package.json', 'package.json', 'tools/pnpm/package.json', 'tools/yarn1/package.json', 'tools/berry/package.json', 'tools/bun/package.json']);
  assert.deepEqual(targets.map((t) => [t.dir, t.lockfile, t.argv.join(' ')]), [
    ['.', 'package-lock.json', 'npm install --ignore-scripts --no-audit --no-fund'],
    ['tools/berry', 'tools/berry/yarn.lock', 'yarn install --mode=skip-build --no-immutable'],
    ['tools/bun', 'tools/bun/bun.lock', 'bun install --ignore-scripts'],
    ['tools/pnpm', 'tools/pnpm/pnpm-lock.yaml', 'pnpm install --ignore-scripts --no-frozen-lockfile'],
    ['tools/yarn1', 'tools/yarn1/yarn.lock', 'yarn install --ignore-scripts --non-interactive'],
  ]);
  const bare = tree({ 'package.json': JSON.stringify({ workspaces: ['apps/*'] }), 'apps/a/package.json': '{}', 'solo/package.json': '{}' });
  assert.deepEqual(installTargets(bare, ['apps/a/package.json', 'solo/package.json']).map((t) => [t.dir, t.lockfile, t.argv.at(-1)]), [
    ['.', null, '--no-package-lock'],
    ['solo', null, '--no-package-lock'],
  ]);
});

test('installDependencies reports what ran, the lockfiles it changed, and stops at the first failure', () => {
  const dir = tree({ 'package.json': '{}', 'package-lock.json': '{"v":1}\n', 'nested/package.json': '{}', 'nested/package-lock.json': '{}' });
  const seen = [];
  const spawn = (bin, args, options) => {
    seen.push([bin, Array.isArray(args) ? args.join(' ') : null, options.cwd]);
    if (options.cwd === dir) writeFileSync(join(dir, 'package-lock.json'), '{"v":2}\r\n');
    return { status: options.cwd.endsWith('nested') ? 1 : 0, stderr: 'npm error 404 not found\n' };
  };
  const r = installDependencies(dir, ['package.json', 'nested/package.json'], { spawn });
  assert.equal(r.ok, false);
  assert.deepEqual(r.runs.map((x) => [x.dir, x.exitCode]), [['.', 0], ['nested', 1]]);
  assert.deepEqual(r.lockfiles.map((l) => l.path), ['package-lock.json']);
  assert.match(r.output, /404 not found/);
  const custom = installDependencies(dir, ['package.json'], { cmd: 'make deps', spawn: (cmd, options) => { seen.push([cmd, options.shell]); return { status: 0 }; } });
  assert.deepEqual([custom.ok, custom.runs, seen.at(-1)], [true, [{ dir: '.', cmd: 'make deps', exitCode: 0 }], ['make deps', true]]);
});

const installedVersion = (dir) => Number(readFileSync(join(dir, 'node_modules/acme-sdk/index.cjs'), 'utf8').match(/version = (\d)/)[1]);

// A consumer of acme-sdk, with versions 1 and 2 as local packages, so npm installs them without a network.
// The rule moves the dependency to version 2, and the test command fails unless version 2 is installed.
function consumer() {
  const dir = tree({
    'package.json': JSON.stringify({ name: 'consumer', private: true, dependencies: { 'acme-sdk': 'file:vendor/acme-1' } }, null, 2) + '\n',
    'vendor/acme-1/package.json': JSON.stringify({ name: 'acme-sdk', version: '1.0.0', main: 'index.cjs' }),
    'vendor/acme-1/index.cjs': 'exports.version = 1;\n',
    'vendor/acme-2/package.json': JSON.stringify({ name: 'acme-sdk', version: '2.0.0', main: 'index.cjs' }),
    'vendor/acme-2/index.cjs': 'exports.version = 2;\n',
    'src/app.ts': "import acme from 'acme-sdk';\nexport const v = acme.version;\n",
  });
  npm(dir, 'install', '--ignore-scripts', '--no-audit', '--no-fund');
  const rules = join(tree({}), 'rules.json');
  writeFileSync(rules, JSON.stringify({
    schema: 'apimigrate/1', draft: true, provider: 'acme', package: 'acme-sdk', id: 'acme-sdk-1-to-2', from: '1.0.0', to: '2.0.0', sunset: '2099-01-01',
    rules: [{ id: 'dependency', kind: 'rename-dependency', confidence: 'likely', evidence: 'test', match: { dependency: 'acme-sdk' }, transform: { version: 'file:vendor/acme-2' } }],
  }));
  const seen = join(tree({}), 'versions.txt');
  const check = join(dirname(seen), 'check.cjs');
  writeFileSync(check, `const v = require(require.resolve('acme-sdk', { paths: [process.cwd()] })).version;\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, v + '\\n');\nprocess.exit(v === Number(process.env.WANT ?? 2) ? 0 : 1);\n`);
  return { dir, rules, seen, testCmd: `node ${JSON.stringify(check)}` };
}

test('apply --install installs the new version and updates the lockfile before the tests, and the evidence records it', async () => {
  const { dir, rules, seen, testCmd } = consumer();
  const lockBefore = readFileSync(join(dir, 'package-lock.json'), 'utf8');
  const r = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install', '--test-cmd', testCmd]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /installed with npm install --ignore-scripts --no-audit --no-fund in \., updated package-lock\.json/);
  assert.equal(readFileSync(seen, 'utf8'), '2\n', 'the tests ran against version 2');
  assert.notEqual(readFileSync(join(dir, 'package-lock.json'), 'utf8'), lockBefore);
  assert.match(readFileSync(join(dir, 'package-lock.json'), 'utf8'), /vendor\/acme-2/);
  const evidence = JSON.parse(readFileSync(join(dir, '.apimigrate/evidence.json'), 'utf8'));
  assert.deepEqual(evidence.install.runs, [{ dir: '.', cmd: 'npm install --ignore-scripts --no-audit --no-fund', exitCode: 0 }]);
  assert.deepEqual(changedPaths(evidence), ['package-lock.json', 'package.json']);
  const body = prBody(evidence);
  assert.match(body, /\| Install \| `npm install --ignore-scripts --no-audit --no-fund` in `\.`, exit code 0 \|/);
  assert.match(body, /`package-lock\.json` was updated/);
  assert.doesNotMatch(body, /Regenerate the lockfile/);

  // A lockfile among the scanned files is checked against the digest the install produced.
  const [lock] = evidence.install.lockfiles;
  const base = { 'package-lock.json': lockBefore };
  assert.equal(checkHead(base, { 'package-lock.json': readFileSync(join(dir, 'package-lock.json'), 'utf8') }, { ...evidence, files: [] }).ok, true);
  assert.deepEqual(checkHead(base, { 'package-lock.json': '{}' }, { ...evidence, files: [] }).drift, [lock.path]);
  assert.equal(checkHead({}, {}, { ...evidence, files: [] }).ok, true, 'an unscanned lockfile is not compared');
});

test('a failed install fails apply before the tests, and without --install the lockfile is left alone', async () => {
  const failing = consumer();
  const r = await cli(['apply', '--root', failing.dir, '--rules', failing.rules, '--allow-unsigned', '--install-cmd', 'node -e "process.exit(3)"', '--test-cmd', failing.testCmd]);
  assert.equal(r.code, 1);
  assert.match(r.err, /install failed: node -e "process\.exit\(3\)" in \. exited with 3, tests were not run/);
  assert.equal(existsSync(failing.seen), false);

  const plain = consumer();
  const lock = readFileSync(join(plain.dir, 'package-lock.json'), 'utf8');
  const p = await cli(['apply', '--root', plain.dir, '--rules', plain.rules, '--allow-unsigned']);
  assert.equal(p.code, 0, p.err);
  assert.match(p.out, /update the lockfile with your package manager before merging/);
  assert.equal(readFileSync(join(plain.dir, 'package-lock.json'), 'utf8'), lock);
  assert.equal(JSON.parse(readFileSync(join(plain.dir, '.apimigrate/evidence.json'), 'utf8')).install, null);
});

test('watch mode commits the updated lockfile, and installs the base versions again before the next upgrade', async () => {
  const { dir, rules, seen, testCmd } = consumer();
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.apimigrate/\n');
  const remote = mkdtempSync(join(tmpdir(), 'remote-'));
  git(remote, 'init', '-q', '--bare');
  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'base');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');

  // The second upgrade only renames a call, so it installs nothing and its tests must see version 1 again.
  const second = join(dirname(rules), 'second.json');
  writeFileSync(second, JSON.stringify({ ...JSON.parse(readFileSync(rules, 'utf8')), id: 'acme-sdk-1-to-2-calls', rules: [{ id: 'v', kind: 'rename-method', confidence: 'likely', evidence: 'test', match: { call: 'version' }, transform: { to: 'release' } }] }));
  const entry = (rulesPath, pkg) => ({ name: pkg, package: pkg, line: '1', from: '1.0.0', to: '2.0.0', manifests: [], source: 'draft', signed: false, rules: rulesPath, ruleCount: 1, likely: 1, needsReview: 0, upstream: { from: { repo: 'github.com/acme/sdk', ref: 'v1.0.0', dir: '' }, to: { repo: 'github.com/acme/sdk', ref: 'v2.0.0', dir: '' } } });
  const planPath = join(dirname(rules), 'plan.json');
  writeFileSync(planPath, JSON.stringify({ schema: 'apimigrate-watch/1', upgrades: [entry(rules, 'acme-sdk'), entry(second, 'acme-sdk-calls')], skipped: [] }));

  const calls = [];
  const log = [];
  process.env.WANT = '2';
  const code = await openWatchPullRequests({ root: dir, planPath, testCmd, gh: (args) => { calls.push(args); process.env.WANT = '1'; }, out: (x) => log.push(x), err: (x) => log.push(x) });
  delete process.env.WANT;
  assert.equal(code, 0, log.join('\n'));
  assert.equal(readFileSync(seen, 'utf8'), '2\n1\n', 'the first upgrade was tested with version 2, the second with version 1 again');
  assert.equal(git(remote, 'diff', '--name-only', 'main', 'apimigrate/acme-sdk-1-to-2-unsigned'), 'package-lock.json\npackage.json');
  assert.match(git(remote, 'show', 'apimigrate/acme-sdk-1-to-2-unsigned:package-lock.json'), /vendor\/acme-2/);
  assert.equal(calls.length, 1, 'the second upgrade changed no file, so it opened nothing');
  assert.match(log.join('\n'), /acme-sdk-calls 1\.0\.0 -> 2\.0\.0: nothing to migrate/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(installedVersion(dir), 1, 'the base version is installed at the end');
});
