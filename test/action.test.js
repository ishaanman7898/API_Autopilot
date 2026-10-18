import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { branchName, changedPaths, prBody } from '../src/prbody.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Git on Windows can check files out with CRLF line endings, so compare as LF.
const readRepoFile = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const evidence = {
  rule: { id: 'acme sdk/1 to 2', provider: 'acme', contentHash: 'a'.repeat(64), signed: true, keyId: 'k1' },
  callSites: [{ file: 'a.ts', line: 1, ruleId: 'm', proven: true }, { file: 'b.json', line: 2, ruleId: 'r', proven: false }],
  unresolved: [{ file: 'src/x`y.ts', line: 9, ruleId: 'cap', reason: 'receiver\ncannot be traced' }],
  files: [{ path: 'a.ts', before: 'x', after: 'y' }, { path: 'gone.ts', before: 'x', after: null }],
  deterministic: { replayDigest: 'b'.repeat(64) },
  gate: { ok: true, findings: [] },
  tests: { cmd: 'npm test', exitCode: 0 },
};

test('paths exclude deletions and branch names are safe', () => {
  assert.deepEqual(changedPaths(evidence), ['a.ts']);
  assert.equal(branchName(evidence, '123'), 'apimigrate/acme-sdk-1-to-2-123');
  assert.match(branchName({ rule: { id: '../../x;rm -rf' } }, '9; echo'), /^apimigrate\/[\w.-]+-9$/);
  assert.doesNotMatch(branchName({ rule: { id: '$(whoami)' } }, 'a'), /[$();\s]/);
});

test('the pull request body states what happened and how to verify, and flattens untrusted text', () => {
  const body = prBody(evidence, { rulesPath: 'migrations/r.json' });
  assert.match(body, /Opened as a draft by apimigrate\. It never merges itself\./);
  assert.match(body, /\| Gate \| passed \|/);
  assert.match(body, /1 from regex rules and not parse-verified/);
  assert.match(body, /apimigrate verify --rules migrations\/r\.json/);
  assert.match(body, /`src\/xy\.ts:9`/);
  assert.doesNotMatch(body, /receiver\ncannot/);
  assert.ok(body.length < 65000);
  assert.doesNotMatch(body, /Regenerate the lockfile/);
  const manifest = prBody({ ...evidence, files: [...evidence.files, { path: 'packages/web/package.json', before: 'x', after: 'y' }] });
  assert.match(manifest, /`package\.json` dependencies changed\. Regenerate the lockfile/);
});

test('very large evidence is truncated to fit a pull request body', () => {
  const big = { ...evidence, unresolved: Array.from({ length: 5000 }, (_, i) => ({ file: `f${i}.ts`, line: i, ruleId: 'cap', reason: 'x'.repeat(50) })) };
  const body = prBody(big);
  assert.ok(body.length <= 60001);
  assert.match(body, /and 4950 more/);
});

test('the helper script prints the same values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  const file = join(dir, 'evidence.json');
  writeFileSync(file, JSON.stringify(evidence));
  const run = (...a) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'pr.mjs'), ...a], { encoding: 'utf8' });
  assert.equal(run('paths', file).stdout, 'a.ts');
  assert.equal(run('branch', file, '77').stdout, 'apimigrate/acme-sdk-1-to-2-77');
  assert.match(run('body', file, 'r.json').stdout, /## Migration/);
  assert.equal(run('nonsense', file).status, 2);
});

test('the action opens draft pull requests only and never merges', () => {
  const action = readRepoFile('action.yml');
  assert.match(action, /gh pr create --draft/);
  assert.doesNotMatch(action, /gh pr merge|--auto|--admin|enable-auto-merge/);
  assert.doesNotMatch(action, /git add -A|git add \./, 'only files named by the evidence are staged');
  const scripts = action.split(/\n\s+run: /).slice(1).map((s) => s.split(/\n\s+- name|\n\s+-\s+uses/)[0]).join('\n');
  assert.doesNotMatch(scripts, /\$\{\{/, 'no expression is interpolated into a shell script');
  for (const f of ['examples/workflow.yml', '.github/workflows/ci.yml']) {
    const text = readRepoFile(f);
    assert.doesNotMatch(text, /uses: [^@\n]+@v\d/, `${f} pins actions by commit`);
  }
  const workflow = readRepoFile('examples/workflow.yml');
  assert.match(workflow, /permissions:\n  contents: write\n  pull-requests: write/);
});
