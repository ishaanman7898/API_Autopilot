import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { ruleSet } from './fixtures/match-cases.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'apimigrate.js');
const method = { id: 'm', kind: 'rename-method', match: { call: 'charges.create' }, transform: { to: 'payments.create' } };
const param = { id: 'p', kind: 'rename-param', match: { call: 'payments.create', param: 'amount_cents' }, transform: { to: 'amount' } };
const manual = { id: 'cap', kind: 'manual', match: { call: 'charges.capture' }, fallback: { prompt: 'Use payments.confirm.' } };

const SRC = "import Acme from 'acme-sdk';\nconst client = new Acme();\nexport const charge = () => client.charges.create({ amount_cents: 5 });\nexport const capture = () => client.charges.capture('x');\n";
const TEST = "import { charge } from '../src/billing';\ntest('charge', () => {\n  expect(charge()).toBeDefined();\n  expect(1).toBe(1);\n});\n";
const REPO = { 'src/billing.ts': SRC, 'test/billing.test.ts': TEST, '.github/workflows/ci.yml': 'name: ci\non: push\n' };

const tmp = (p = 'cli-') => mkdtempSync(join(tmpdir(), p));
function write(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}
async function run(...argv) {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// Publisher setup: keys in kdir, a signed rule file at rules.
async function publisher(rules = [method, param], mutate = (rs) => rs) {
  const dir = tmp('pub-');
  assert.equal((await run('keygen', '--out', dir)).code, 0);
  const rulesPath = join(dir, 'rules.json');
  writeFileSync(rulesPath, JSON.stringify(mutate(ruleSet(rules))));
  assert.equal((await run('sign', rulesPath, '--key', join(dir, 'apimigrate-private.pem'))).code, 0);
  return { dir, rules: rulesPath, keys: join(dir, 'apimigrate-keys.json'), pem: join(dir, 'apimigrate-public.pem'), priv: join(dir, 'apimigrate-private.pem') };
}
const apply = (pub, repo, ...extra) => run('apply', '--rules', pub.rules, '--keys', pub.keys, '--root', repo, ...extra);

test('apply, verify, then drift in the base or head makes verify fail', async () => {
  const pub = await publisher();
  const base = write(tmp(), REPO);
  const work = tmp();
  cpSync(base, work, { recursive: true });

  const applied = await apply(pub, work);
  assert.equal(applied.code, 0, applied.err);
  assert.match(readFileSync(join(work, 'src/billing.ts'), 'utf8'), /client\.payments\.create\(\{ amount: 5 \}\)/);
  assert.match(applied.out, /1 unresolved|0 unresolved/);

  const evidence = join(work, '.apimigrate', 'evidence.json');
  const ok = await run('verify', '--rules', pub.rules, '--evidence', evidence, '--root', base, '--head', work, '--keys', pub.keys);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /replay matches/);
  assert.match(ok.out, /head tree matches/);

  writeFileSync(join(work, 'src/billing.ts'), readFileSync(join(work, 'src/billing.ts'), 'utf8') + 'steal();\n');
  const headDrift = await run('verify', '--rules', pub.rules, '--evidence', evidence, '--root', base, '--head', work);
  assert.equal(headDrift.code, 1);
  assert.match(headDrift.err, /differs: src\/billing\.ts/);

  writeFileSync(join(base, 'src/billing.ts'), SRC + '// drift\n');
  const baseDrift = await run('verify', '--rules', pub.rules, '--evidence', evidence, '--root', base);
  assert.equal(baseDrift.code, 1);
  assert.match(baseDrift.err, /replay failed/);
});

test('the same migration verifies across line endings and rebuilds identical evidence', async () => {
  const pub = await publisher();
  const lf = write(tmp(), REPO);
  const crlf = write(tmp(), Object.fromEntries(Object.entries(REPO).map(([f, t]) => [f, t.replace(/\n/g, '\r\n')])));
  const lfBase = tmp();
  cpSync(lf, lfBase, { recursive: true });
  assert.equal((await apply(pub, lf)).code, 0);
  assert.equal((await apply(pub, crlf)).code, 0);
  const a = JSON.parse(readFileSync(join(lf, '.apimigrate/evidence.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(crlf, '.apimigrate/evidence.json'), 'utf8'));
  delete a.meta; delete b.meta;
  assert.deepEqual(a, b);
  assert.match(readFileSync(join(crlf, 'src/billing.ts'), 'utf8'), /\r\n/, 'line endings are preserved on disk');
  assert.equal((await run('verify', '--rules', pub.rules, '--evidence', join(crlf, '.apimigrate/evidence.json'), '--root', lfBase)).code, 0);
});

test('every trust failure exits 3 and writes nothing', async () => {
  const good = await publisher();
  const other = await publisher();
  const repo = write(tmp(), REPO);
  const unsignedPath = join(tmp(), 'u.json');
  writeFileSync(unsignedPath, JSON.stringify(ruleSet([method])));
  const expired = join(tmp(), 'keys.json');
  const keySet = JSON.parse(readFileSync(good.keys, 'utf8'));
  keySet.keys[0].expires = '2020-01-01';
  writeFileSync(expired, JSON.stringify(keySet));
  const sunset = await publisher([method], (rs) => ({ ...rs, sunset: '2020-01-01' }));
  const tampered = join(tmp(), 't.json');
  const body = JSON.parse(readFileSync(good.rules, 'utf8'));
  body.rules[0].transform.to = 'evil.run';
  writeFileSync(tampered, JSON.stringify(body));

  const attempts = [
    ['unsigned', ['apply', '--rules', unsignedPath, '--keys', good.keys, '--root', repo]],
    ['wrong key', ['apply', '--rules', good.rules, '--keys', other.keys, '--root', repo]],
    ['expired key', ['apply', '--rules', good.rules, '--keys', expired, '--root', repo]],
    ['sunset rule', ['apply', '--rules', sunset.rules, '--keys', sunset.keys, '--root', repo]],
    ['tampered rule', ['apply', '--rules', tampered, '--keys', good.keys, '--root', repo]],
    ['no key source', ['apply', '--rules', good.rules, '--root', repo]],
    ['bad host', ['apply', '--rules', good.rules, '--well-known', 'not a host', '--root', repo]],
    ['check wrong key', ['check', good.rules, '--keys', other.keys]],
  ];
  for (const [name, argv] of attempts) {
    const r = await run(...argv);
    assert.equal(r.code, 3, `${name}: ${r.err}`);
  }
  assert.equal(readFileSync(join(repo, 'src/billing.ts'), 'utf8'), SRC);
  assert.equal(existsSync(join(repo, '.apimigrate')), false);
});

test('pins, allowed providers and --allow-unsigned interact safely', async () => {
  const pub = await publisher();
  const hash = JSON.parse(readFileSync(pub.rules, 'utf8')).signature.hash;
  const repo = (config) => write(tmp(), { ...REPO, '.apimigrate.yml': config });
  assert.equal((await apply(pub, repo(`pins:\n  - ${hash}\n`))).code, 0);
  const wrongPin = await apply(pub, repo(`pins:\n  - ${'0'.repeat(64)}\n`));
  assert.equal(wrongPin.code, 3);
  assert.match(wrongPin.err, /not in the pins list/);
  const unsignedPinned = await run('apply', '--rules', pub.rules, '--allow-unsigned', '--root', repo(`pins:\n  - ${hash}\n`));
  assert.equal(unsignedPinned.code, 3);
  assert.equal((await apply(pub, repo('providers: [someone-else]\n'))).code, 3);
  assert.equal((await apply(pub, repo('providers: [acme]\n'))).code, 0);
  const unsigned = await run('apply', '--rules', pub.rules, '--allow-unsigned', '--root', repo(''));
  assert.equal(unsigned.code, 0);
  assert.match(unsigned.err, /signature checks skipped/);
});

test('usage and config errors exit 2', async () => {
  const pub = await publisher();
  const repo = write(tmp(), REPO);
  const cases = [
    ['unknown command', ['frobnicate']],
    ['unknown flag', ['apply', '--rules', pub.rules, '--nope']],
    ['missing flag value', ['apply', '--rules']],
    ['missing rules', ['apply', '--keys', pub.keys, '--root', repo]],
    ['extra positional', ['lint', 'a', 'b']],
    ['no positional', ['lint']],
    ['bad rule file', ['lint', join(repo, 'src/billing.ts')]],
    ['draft without files', ['draft', 'a.json']],
  ];
  for (const [name, argv] of cases) assert.equal((await run(...argv)).code, 2, name);
  for (const [name, config] of [['unknown setting', 'pin: [x]\n'], ['draft false', 'draft: false\n'], ['bad pin', 'pins: [abc]\n'], ['escaping path', 'paths: [..]\n'], ['not yaml', 'what is this\n']]) {
    const r = await apply(pub, write(tmp(), { ...REPO, '.apimigrate.yml': config }));
    assert.equal(r.code, 2, `${name}: ${r.err}`);
  }
});

test('dry run prints diffs and writes nothing', async () => {
  const pub = await publisher();
  const repo = write(tmp(), REPO);
  const r = await apply(pub, repo, '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^--- a\/src\/billing\.ts/m);
  assert.match(r.out, /^-export const charge/m);
  assert.match(r.out, /^\+export const charge/m);
  assert.match(r.out, /would change/);
  assert.equal(readFileSync(join(repo, 'src/billing.ts'), 'utf8'), SRC);
  assert.equal(existsSync(join(repo, '.apimigrate')), false);
});

test('the gate fails the run when the test command touches CI config, and when tests fail', async () => {
  const pub = await publisher();
  const touch = await apply(pub, write(tmp(), REPO), '--test-cmd', `node -e "require('fs').appendFileSync('.github/workflows/ci.yml','x: 1\\n')"`);
  assert.equal(touch.code, 1);
  assert.match(touch.err, /gate: \.github\/workflows\/ci\.yml:\d+: protected test or CI file changed/);
  const failing = await apply(pub, write(tmp(), REPO), '--test-cmd', 'node -e "process.exit(4)"');
  assert.equal(failing.code, 1);
  assert.match(failing.err, /tests failed with exit code 4/);
  const passing = await apply(pub, write(tmp(), REPO), '--test-cmd', 'node -e "0"');
  assert.equal(passing.code, 0);
  const strict = await apply(await publisher([method, manual]), write(tmp(), REPO), '--strict');
  assert.equal(strict.code, 1);
  assert.match(strict.err, /strict: unresolved/);
});

test('the gate command compares two trees', async () => {
  const base = write(tmp(), REPO);
  const head = write(tmp(), { ...REPO, 'test/billing.test.ts': TEST.replace("  expect(1).toBe(1);\n", '') });
  const r = await run('gate', base, head);
  assert.equal(r.code, 1);
  assert.match(r.err, /test\/billing\.test\.ts: assertions dropped from 2 to 1/);
  assert.equal((await run('gate', base, base)).code, 0);
});

test('agent-apply runs agent output through the gate, restricted to queued files', async () => {
  const pub = await publisher([method, manual]);
  const base = write(tmp(), REPO);
  const work = tmp();
  cpSync(base, work, { recursive: true });
  const applied = await apply(pub, work);
  assert.equal(applied.code, 0, applied.err);
  assert.match(applied.out, /unresolved: src\/billing\.ts:4 cap/);
  const queue = JSON.parse(readFileSync(join(work, '.apimigrate/unresolved.json'), 'utf8'));
  assert.equal(queue.items[0].task, 'Use payments.confirm.');

  const results = join(tmp(), 'agent.json');
  const migrated = readFileSync(join(work, 'src/billing.ts'), 'utf8').replace('charges.capture', 'payments.confirm');
  writeFileSync(results, JSON.stringify({ files: { 'test/billing.test.ts': 'x' } }));
  const outside = await run('agent-apply', '--results', results, '--root', work);
  assert.equal(outside.code, 1);
  assert.match(outside.err, /not a file with an unresolved call site/);

  writeFileSync(results, JSON.stringify({ files: { 'src/billing.ts': migrated + "const k = 'AKIAABCDEFGHIJKLMNOP';\n" } }));
  const leak = await run('agent-apply', '--results', results, '--root', work);
  assert.equal(leak.code, 1);
  assert.match(leak.err, /looks like a aws-access-key/);
  assert.doesNotMatch(readFileSync(join(work, 'src/billing.ts'), 'utf8'), /AKIA/);

  writeFileSync(results, JSON.stringify({ files: { 'src/billing.ts': migrated } }));
  const dry = await run('agent-apply', '--results', results, '--root', work, '--dry-run');
  assert.equal(dry.code, 0);
  assert.match(readFileSync(join(work, 'src/billing.ts'), 'utf8'), /charges\.capture/);
  const done = await run('agent-apply', '--results', results, '--root', work);
  assert.equal(done.code, 0, done.err);
  assert.match(readFileSync(join(work, 'src/billing.ts'), 'utf8'), /payments\.confirm/);

  const evidence = JSON.parse(readFileSync(join(work, '.apimigrate/evidence.json'), 'utf8'));
  assert.equal(evidence.agent.edited.length, 1);
  const verified = await run('verify', '--rules', pub.rules, '--evidence', join(work, '.apimigrate/evidence.json'), '--root', base, '--head', work);
  assert.equal(verified.code, 0, verified.err);
  writeFileSync(join(work, 'src/billing.ts'), migrated + '// later edit\n');
  assert.equal((await run('verify', '--rules', pub.rules, '--evidence', join(work, '.apimigrate/evidence.json'), '--root', base, '--head', work)).code, 1);
  const stale = await run('agent-apply', '--results', results, '--root', work);
  assert.equal(stale.code, 1);
  assert.match(stale.err, /working tree changed since apply/);
});

test('draft and sign: drafts are written with marks and cannot be signed until reviewed', async () => {
  const dir = tmp();
  const spec = (op, route) => ({ openapi: '3.0.3', paths: { [route]: { post: { operationId: op, responses: { 200: {} } } } } });
  write(dir, { 'old.json': JSON.stringify(spec('charges_create', '/charges')), 'new.json': JSON.stringify(spec('payments_create', '/charges')), 'old.yaml': 'openapi: 3.0.3\n' });
  assert.equal((await run('draft', join(dir, 'old.yaml'), join(dir, 'new.json'))).code, 2);
  const out = join(dir, 'draft.json');
  const r = await run('draft', join(dir, 'old.json'), join(dir, 'new.json'), '--provider', 'acme', '--package', 'acme-sdk', '--from', '1', '--to', '2', '--out', out);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(dir, 'draft.report.json')));
  assert.equal((await run('keygen', '--out', dir)).code, 0);
  const refused = await run('sign', out, '--key', join(dir, 'apimigrate-private.pem'));
  assert.equal(refused.code, 2);
  assert.match(refused.err, /refusing to sign/);
  assert.equal((await run('keygen', '--out', dir)).code, 2, 'keygen refuses to overwrite');
});

test('help, per command help and version', async () => {
  const all = await run('help');
  assert.equal(all.code, 0);
  for (const c of ['keygen', 'lint', 'sign', 'check', 'draft', 'apply', 'agent-apply', 'verify', 'gate']) {
    assert.match(all.out, new RegExp(`^  ${c}\\s`, 'm'));
    const one = await run(c, '--help');
    assert.equal(one.code, 0);
    assert.match(one.out, new RegExp(`^usage: apimigrate ${c}`));
  }
  assert.match((await run('--version')).out, /^\d+\.\d+\.\d+$/);
  assert.equal((await run()).code, 0);
});

test('the bin entry sets the exit code', () => {
  const r = spawnSync(process.execPath, [BIN, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
  assert.equal(spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }).status, 0);
});
