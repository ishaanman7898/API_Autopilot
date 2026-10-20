import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../src/cli.js';
import { lineHunks } from '../src/diffview.js';
import { prBody } from '../src/prbody.js';
import { compareErrors, typecheckAgentEdits, typecheckChanges } from '../src/typecheck.js';
import { openWatchPullRequests } from '../src/watchpr.js';

function tree(files, dir = mkdtempSync(join(tmpdir(), 'typecheck-'))) {
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
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// A fake SDK whose version 2 moved the leading path argument of update into its params object, as Cloudflare 7 did.
const SDK = {
  1: 'export interface UpdateParams { metadata?: string }\nexport declare class OldValues { count: number; update(namespaceId: string, key: string, value: string, params?: UpdateParams): Promise<void> }\nexport declare const values: OldValues;\n',
  2: 'export interface UpdateParams { namespace_id: string; value: string; metadata?: string }\nexport declare class Values { count: string; update(key: string, params: UpdateParams): Promise<void> }\nexport declare const values: Values;\n',
};
const sdkFiles = (v) => ({ 'package.json': JSON.stringify({ name: 'sdk', version: `${v}.0.0`, types: 'index.d.ts', main: 'index.js' }), 'index.d.ts': SDK[v], 'index.js': '' });
const prefixed = (prefix, files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [`${prefix}/${k}`, v]));
const TSCONFIG = (options) => JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', noEmit: true, ...options }, include: ['src'] }, null, 2);

// A consumer with sdk 1 installed. The install command puts sdk 2 in its place, without npm. The rule moves the
// dependency to 2.0.0 and rewrites code with the given replace rules, the way an engine fault would.
function consumer(files, replaces, extra = []) {
  const dir = tree({
    'package.json': JSON.stringify({ name: 'consumer', private: true, dependencies: { sdk: '1.0.0' } }, null, 2) + '\n',
    'tsconfig.json': TSCONFIG({ strict: true }),
    ...prefixed('node_modules/sdk', sdkFiles(1)),
    ...files,
  });
  const tools = tree({ ...prefixed('sdk-2', sdkFiles(2)) });
  const install = join(tools, 'install.cjs');
  writeFileSync(install, `require('fs').cpSync(${JSON.stringify(join(tools, 'sdk-2'))}, 'node_modules/sdk', { recursive: true });\n`);
  const rules = join(tools, 'rules.json');
  writeFileSync(rules, JSON.stringify({
    schema: 'apimigrate/1', draft: true, provider: 'acme', package: 'sdk', id: 'sdk-1-to-2', from: '1.0.0', to: '2.0.0', sunset: '2099-01-01',
    rules: [
      { id: 'dependency', kind: 'rename-dependency', confidence: 'likely', evidence: 'test', match: { dependency: 'sdk' }, transform: { version: '2.0.0' } },
      ...replaces.map(([pattern, to], i) => ({ id: `r${i}`, kind: 'replace', confidence: 'likely', evidence: 'test', match: { pattern, files: ['.ts'] }, transform: { to } })),
      ...extra,
    ],
  }));
  return { dir, rules, installCmd: `node ${JSON.stringify(install)}` };
}
const evidenceOf = (dir) => JSON.parse(readFileSync(join(dir, '.apimigrate/evidence.json'), 'utf8'));

// The first Cloudflare argument benchmark run spread the old string argument into the new params object.
const KV = "import { values } from 'sdk';\n\nexport async function save(ns: string, key: string, data: object) {\n  await values.update(ns, key, JSON.stringify(data));\n}\n\nexport const broken: number = 'already wrong';\n";

test('a rewrite that adds a type error fails the gate, names it, and the evidence and pull request body record it', async () => {
  const { dir, rules, installCmd } = consumer({ 'src/kv.ts': KV }, [['values\\.update\\(ns, key, JSON\\.stringify\\(data\\)\\)', 'values.update(key, {\n    namespace_id: ns,\n    ...JSON.stringify(data),\n  })']]);
  const r = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install-cmd', installCmd, '--typecheck']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /^gate: src\/kv\.ts:6: type error added: TS2698 Spread types may only be created from object types\.$/m);
  assert.match(r.out, /type-checked 1 changed files with TypeScript 5\.\d+\.\d+: \d errors added on changed lines/);
  assert.doesNotMatch(r.out + r.err, /already wrong|TS2322|TS2554/, 'the error that was there before, and the upgrade error the rewrite fixed, are not reported');

  const evidence = evidenceOf(dir);
  assert.equal(evidence.gate.ok, false);
  assert.ok(evidence.gate.findings.some((f) => f.code === 'type-error-added' && f.file === 'src/kv.ts' && f.line === 6));
  assert.equal(evidence.typecheck.ran, true);
  assert.deepEqual(evidence.typecheck.projects, [{ config: 'tsconfig.json', files: ['src/kv.ts'] }]);
  assert.deepEqual(evidence.typecheck.added.find((e) => e.code === 'TS2698'), { file: 'src/kv.ts', line: 6, code: 'TS2698', message: 'Spread types may only be created from object types.' });
  assert.deepEqual(evidence.typecheck.otherLines, []);
  const body = prBody(evidence);
  assert.match(body, /\| Gate \| failed, \d findings \|/);
  assert.match(body, /\| Type check \| 1 files with TypeScript `5\.\d+\.\d+`, \d errors added on changed lines \|/);
  assert.match(body, /### Type errors added\n\nThe rewritten text has these errors on lines the rewrite changed, and the original text does not\.\n\n- `src\/kv\.ts:6` `TS2698 Spread types may only be created from object types\.`/);
});

test('a correct rewrite passes, and a new error on a line it did not change is listed without failing the run', async () => {
  // The rewrite of other.ts fixes an import the upgrade broke, which uncovers an error on a line it did not touch.
  const other = "import { OldValues } from 'sdk';\ndeclare const v: OldValues;\nexport const n: number = v.count;\n";
  const { dir, rules, installCmd } = consumer({ 'src/kv.ts': KV, 'src/other.ts': other }, [
    ['values\\.update\\(ns, key, JSON\\.stringify\\(data\\)\\)', 'values.update(key, {\n    namespace_id: ns,\n    value: JSON.stringify(data),\n  })'],
    ['import \\{ OldValues \\}', 'import { Values as OldValues }'],
  ]);
  const r = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install-cmd', installCmd, '--typecheck']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /type-checked 2 changed files with TypeScript 5\.\d+\.\d+: 0 errors added on changed lines/);
  assert.match(r.out, /note: new type error on a line the rewrite did not change, not counted by the gate: src\/other\.ts:3: TS2322 Type 'string' is not assignable to type 'number'\./);
  const evidence = evidenceOf(dir);
  assert.equal(evidence.gate.ok, true);
  assert.deepEqual(evidence.typecheck.added, []);
  assert.deepEqual(evidence.typecheck.otherLines, [{ file: 'src/other.ts', line: 3, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }]);
  const body = prBody(evidence);
  assert.match(body, /\| Type check \| 2 files with TypeScript `5\.\d+\.\d+`, 0 errors added on changed lines, 1 new on other lines \|/);
  assert.match(body, /### New type errors on unchanged lines\n\n.*so the gate does not count them\. Check them before marking this ready\.\n\n- `src\/other\.ts:3` `TS2322 Type 'string' is not assignable to type 'number'\.`/);
  assert.doesNotMatch(body, /### Type errors added/);
});

test('the check uses the repository\'s own options: strict and path aliases from a referenced config', async () => {
  // A solution-style tsconfig.json, as Vite writes it, hands src to tsconfig.app.json, which turns on strict and
  // defines the @/ alias. Without the alias the spread value would be untyped, and without strict TS2783 is not reported.
  const files = (strict) => ({
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
    'tsconfig.app.json': TSCONFIG({ strict, paths: { '@/*': ['./src/*'] } }),
    'src/defaults.ts': "import type { UpdateParams } from 'sdk';\nexport const defaults: UpdateParams = { namespace_id: 'main', value: '' };\n",
    'src/put.ts': "import { values } from 'sdk';\nimport { defaults } from '@/defaults';\n\nexport const put = (ns: string, key: string) => values.update(ns, key, defaults);\n",
  });
  const rewrite = [['values\\.update\\(ns, key, defaults\\)', 'values.update(key, { namespace_id: ns, ...defaults })']];
  const strict = consumer(files(true), rewrite);
  const r = await cli(['apply', '--root', strict.dir, '--rules', strict.rules, '--allow-unsigned', '--install-cmd', strict.installCmd, '--typecheck']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /^gate: src\/put\.ts:4: type error added: TS2783 'namespace_id' is specified more than once, so this usage will be overwritten\.$/m);
  assert.deepEqual(evidenceOf(strict.dir).typecheck.projects, [{ config: 'tsconfig.app.json', files: ['src/put.ts'] }]);

  const loose = consumer(files(false), rewrite);
  const l = await cli(['apply', '--root', loose.dir, '--rules', loose.rules, '--allow-unsigned', '--install-cmd', loose.installCmd, '--typecheck']);
  assert.equal(l.code, 0, l.out + l.err);
  assert.deepEqual(evidenceOf(loose.dir).typecheck.added, []);
});

test('an error the original code had with the old versions does not count, though the upgrade hid it', async () => {
  // With sdk 1 the call already passes an unknown key. With sdk 2 the original call only shows the wrong argument
  // count, and the rewritten call shows the unknown key again.
  const files = { 'src/meta.ts': "import { values } from 'sdk';\n\nexport const tag = (ns: string, key: string, v: string) => values.update(ns, key, v, { metadata: '', body: 1 });\n" };
  const { dir, rules, installCmd } = consumer(files, [['values\\.update\\(ns, key, v, \\{ ', 'values.update(key, { namespace_id: ns, value: v, ']]);
  const r = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install-cmd', installCmd, '--typecheck']);
  assert.equal(r.code, 0, r.out + r.err);
  const evidence = evidenceOf(dir);
  assert.equal(evidence.typecheck.baseline, true);
  assert.deepEqual(evidence.typecheck.added, []);
  const head = { 'src/meta.ts': readFileSync(join(dir, 'src/meta.ts'), 'utf8') };
  assert.deepEqual(typecheckChanges(dir, files, head).added, [{ file: 'src/meta.ts', line: 3, code: 'TS2353', message: "Object literal may only specify known properties, and 'body' does not exist in type 'UpdateParams'." }], 'without the run against sdk 1 it would count');
});

test('without new versions installed the type-check is refused or skipped with a note', async () => {
  const fix = [['values\\.update\\(ns, key, JSON\\.stringify\\(data\\)\\)', 'values.update(key, { namespace_id: ns, value: JSON.stringify(data) })']];
  const { dir, rules, installCmd } = consumer({ 'src/kv.ts': KV }, fix);
  const refused = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--typecheck']);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--typecheck needs --install or --install-cmd, since without the new versions installed it would check against the old ones/);

  const dry = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install-cmd', installCmd, '--typecheck', '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /note: type-check not run: --dry-run installs nothing/);

  // Rules that leave package.json alone install nothing, so the old versions are still there.
  const codeOnly = JSON.parse(readFileSync(rules, 'utf8'));
  codeOnly.rules = codeOnly.rules.filter((x) => x.kind !== 'rename-dependency');
  writeFileSync(rules, JSON.stringify(codeOnly));
  const skipped = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install-cmd', installCmd, '--typecheck']);
  assert.equal(skipped.code, 0, skipped.err);
  assert.match(skipped.out, /note: type-check not run: no package.json changed, so no new versions were installed/);
  const evidence = evidenceOf(dir);
  assert.deepEqual(evidence.typecheck, { ran: false, reason: 'no package.json changed, so no new versions were installed' });
  assert.match(prBody(evidence), /\| Type check \| not run: no package.json changed, so no new versions were installed \|/);

  const failedInstall = consumer({ 'src/kv.ts': KV }, fix);
  const f = await cli(['apply', '--root', failedInstall.dir, '--rules', failedInstall.rules, '--allow-unsigned', '--install-cmd', 'node -e "process.exit(3)"', '--typecheck']);
  assert.equal(f.code, 1);
  assert.deepEqual(evidenceOf(failedInstall.dir).typecheck, { ran: false, reason: 'the install failed' });
});

// Queues every values.update call for an agent.
const QUEUE = { id: 'queue', kind: 'manual', confidence: 'likely', evidence: 'test', match: { call: 'values.update' }, fallback: { prompt: 'Move namespace_id into the params object.' } };
const UPDATE = 'values.update(ns, key, JSON.stringify(data))';
async function agentRun(dir, text, ...flags) {
  const results = join(mkdtempSync(join(tmpdir(), 'agent-')), 'agent.json');
  writeFileSync(results, JSON.stringify({ files: typeof text === 'string' ? { 'src/kv.ts': text } : text }));
  return cli(['agent-apply', '--root', dir, '--results', results, ...flags]);
}

test('agent-apply --typecheck fails the gate on a type error the agent added, with the versions apply installed', async () => {
  // apply fixes the old error on the last line and queues the call.
  const { dir, rules, installCmd } = consumer({ 'src/kv.ts': KV }, [["'already wrong'", '1']], [QUEUE]);
  const a = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install-cmd', installCmd, '--typecheck']);
  assert.equal(a.code, 0, a.out + a.err);
  assert.match(a.out, /^unresolved: src\/kv\.ts:4 queue/m);
  const applied = readFileSync(join(dir, 'src/kv.ts'), 'utf8');

  // The faulty edit spreads the string into the params object. It also puts back the old error, which the
  // original text has, so that one is not the agent's.
  const faulty = applied.replace(UPDATE, 'values.update(key, {\n    namespace_id: ns,\n    ...JSON.stringify(data),\n  })').replace('= 1;', "= 'already wrong';");
  const f = await agentRun(dir, faulty, '--typecheck');
  assert.equal(f.code, 1, f.out + f.err);
  assert.match(f.out, /^type-checked 1 agent edited files with TypeScript 5\.\d+\.\d+: \d errors added on lines the agent changed$/m);
  assert.match(f.err, /^gate: src\/kv\.ts:6: type error added: TS2698 Spread types may only be created from object types\.$/m);
  assert.doesNotMatch(f.out + f.err, /already wrong|TS2322|TS2554/);
  assert.equal(readFileSync(join(dir, 'src/kv.ts'), 'utf8'), applied, 'nothing was written');
  const unchecked = await agentRun(dir, faulty, '--dry-run');
  assert.equal(unchecked.code, 0, 'without the flag the gate passes it');

  const fixed = applied.replace(UPDATE, 'values.update(key, { namespace_id: ns, value: JSON.stringify(data) })');
  const dry = await agentRun(dir, fixed, '--typecheck', '--dry-run');
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.match(dry.out, /: 0 errors added on lines the agent changed/);
  const ok = await agentRun(dir, fixed, '--typecheck');
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.equal(readFileSync(join(dir, 'src/kv.ts'), 'utf8'), fixed);
  const evidence = evidenceOf(dir);
  assert.equal(evidence.agent.typecheck.ran, true);
  assert.deepEqual(evidence.agent.typecheck.projects, [{ config: 'tsconfig.json', files: ['src/kv.ts'] }]);
  assert.deepEqual([evidence.agent.typecheck.added, evidence.agent.typecheck.otherLines], [[], []]);
  assert.equal(evidence.typecheck.ran, true, 'apply\'s own result stays');
});

test('agent-apply skips the type-check with a note when the evidence does not show the new versions installed', async () => {
  const faulty = (dir) => readFileSync(join(dir, 'src/kv.ts'), 'utf8').replace(UPDATE, 'values.update(key, { namespace_id: ns, ...JSON.stringify(data) })');
  const plain = consumer({ 'src/kv.ts': KV }, [], [QUEUE]);
  assert.equal((await cli(['apply', '--root', plain.dir, '--rules', plain.rules, '--allow-unsigned'])).code, 0);
  const r = await agentRun(plain.dir, faulty(plain.dir), '--typecheck');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^note: type-check not run: the evidence records no install by apply, so the new versions are not known to be installed$/m);
  assert.deepEqual(evidenceOf(plain.dir).agent.typecheck, { ran: false, reason: 'the evidence records no install by apply, so the new versions are not known to be installed' });

  const failed = consumer({ 'src/kv.ts': KV }, [], [QUEUE]);
  assert.equal((await cli(['apply', '--root', failed.dir, '--rules', failed.rules, '--allow-unsigned', '--install-cmd', 'node -e "process.exit(3)"'])).code, 1);
  const f = await agentRun(failed.dir, faulty(failed.dir), '--typecheck', '--dry-run');
  assert.equal(f.code, 0, f.out + f.err);
  assert.match(f.out, /^note: type-check not run: the install in apply failed$/m);
});

test('agent-apply uses apply\'s run against the old versions, so an error the upgrade hid does not count against the agent', async () => {
  // As in the apply test above, the call already passes an unknown key with sdk 1. Here apply only queues it.
  const meta = "import { values } from 'sdk';\n\nexport const tag = (ns: string, key: string, v: string) => values.update(ns, key, v, { metadata: '', body: 1 });\n";
  const body = { line: 3, code: 'TS2353', message: "Object literal may only specify known properties, and 'body' does not exist in type 'UpdateParams'." };
  const { dir, rules, installCmd } = consumer({ 'src/meta.ts': meta }, [], [QUEUE]);
  const a = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install-cmd', installCmd, '--typecheck']);
  assert.equal(a.code, 0, a.out + a.err);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.apimigrate/base.json'), 'utf8')).baseline, { 'src/meta.ts': [{ ...body, end: 3 }] }, 'apply checked the queued file, which it did not change');

  const edited = meta.replace('values.update(ns, key, v, { ', 'values.update(key, { namespace_id: ns, value: v, ');
  const r = await agentRun(dir, { 'src/meta.ts': edited }, '--typecheck');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /: 0 errors added on lines the agent changed/);
  const typecheck = evidenceOf(dir).agent.typecheck;
  assert.equal(typecheck.baseline, true);
  assert.deepEqual([typecheck.added, typecheck.otherLines], [[], []]);
  const texts = (text) => ({ 'src/meta.ts': text });
  const without = typecheckAgentEdits(dir, texts(meta), texts(meta), texts(edited));
  assert.equal(without.baseline, false);
  assert.deepEqual(without.added, [{ file: 'src/meta.ts', ...body }], 'without the run against sdk 1 it would count');
});

test('the pull request body shows the type-check of agent edits, with the new errors on lines the agent did not change', async () => {
  // The agent fixes the import the upgrade broke, which uncovers an error on a line it did not touch.
  const kv = "import { values, OldValues } from 'sdk';\n\ndeclare const v: OldValues;\nexport const n: number = v.count;\n\nexport async function save(ns: string, key: string, data: object) {\n  await values.update(ns, key, JSON.stringify(data));\n}\n";
  const { dir, rules, installCmd } = consumer({ 'src/kv.ts': kv }, [], [QUEUE]);
  assert.equal((await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install-cmd', installCmd, '--typecheck'])).code, 0);
  assert.doesNotMatch(prBody(evidenceOf(dir)), /Agent edits type check|agent did not change/);
  const edited = kv.replace('OldValues }', 'Values as OldValues }').replace(UPDATE, 'values.update(key, { namespace_id: ns, value: JSON.stringify(data) })');
  const r = await agentRun(dir, edited, '--typecheck');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^note: new type error on a line the agent did not change, not counted by the gate: src\/kv\.ts:4: TS2322 Type 'string' is not assignable to type 'number'\.$/m);
  const body = prBody(evidenceOf(dir));
  assert.match(body, /\| Type check \| 0 files with TypeScript `5\.\d+\.\d+`, 0 errors added on changed lines \|\n\| Agent edits type check \| 1 files with TypeScript `5\.\d+\.\d+`, 0 errors added on lines the agent changed, 1 new on other lines \|/);
  assert.match(body, /### New type errors on lines the agent did not change\n\nThe agent edited files have these errors .*Check them before marking this ready\.\n\n- `src\/kv\.ts:4` `TS2322 Type 'string' is not assignable to type 'number'\.`/);
  assert.doesNotMatch(body, /### Type errors added|### New type errors on unchanged lines/);

  const skipped = consumer({ 'src/kv.ts': kv }, [], [QUEUE]);
  assert.equal((await cli(['apply', '--root', skipped.dir, '--rules', skipped.rules, '--allow-unsigned'])).code, 0);
  assert.equal((await agentRun(skipped.dir, edited, '--typecheck')).code, 0);
  assert.match(prBody(evidenceOf(skipped.dir)), /\| Agent edits type check \| not run: the evidence records no install by apply, so the new versions are not known to be installed \|/);
});

test('agent-apply refuses to run after apply\'s gate failed, so the evidence keeps the failure', async () => {
  // The rewrite of the last line adds a type error, and the call is queued.
  const { dir, rules, installCmd } = consumer({ 'src/kv.ts': KV }, [["'already wrong'", 'undefined']], [QUEUE]);
  const a = await cli(['apply', '--root', dir, '--rules', rules, '--allow-unsigned', '--install-cmd', installCmd, '--typecheck']);
  assert.equal(a.code, 1, a.out + a.err);
  assert.match(a.err, /^gate: src\/kv\.ts:7: type error added: TS2322 Type 'undefined' is not assignable to type 'number'\.$/m);
  const applied = readFileSync(join(dir, 'src/kv.ts'), 'utf8');
  const before = evidenceOf(dir);
  const fixed = applied.replace(UPDATE, 'values.update(key, { namespace_id: ns, value: JSON.stringify(data) })');
  for (const flags of [[], ['--typecheck'], ['--dry-run']]) {
    const r = await agentRun(dir, fixed, ...flags);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /^apply's gate: src\/kv\.ts:7: type error added: TS2322 Type 'undefined' is not assignable to type 'number'\.$/m);
    assert.match(r.err, /^agent edits were not applied because apply's gate failed, fix its findings and run apply again$/m);
  }
  assert.equal(readFileSync(join(dir, 'src/kv.ts'), 'utf8'), applied);
  assert.deepEqual(evidenceOf(dir), before);
});

test('a Deno project is checked with the compilerOptions of its deno.json or deno.jsonc, and Deno\'s strict default', () => {
  const put = (call, more = '') => `import { values } from 'sdk';\nimport { defaults } from '#/defaults.ts';\n\nexport const put = (ns: string, key: string) => ${call};\n${more}`;
  const base = { 'src/put.ts': put('values.update(ns, key, defaults)') };
  const head = { 'src/put.ts': put('values.update(key, { namespace_id: ns, ...defaults })') };
  const project = (config) => tree({ ...prefixed('node_modules/sdk', sdkFiles(2)), 'src/defaults.ts': "import type { UpdateParams } from 'sdk';\nexport const defaults: UpdateParams = { namespace_id: 'main', value: '' };\n", ...head, ...config });
  // No compilerOptions, as in sparql-agent. strict is on, the import map's #/ resolves, and so does the .ts extension.
  const deno = project({ 'deno.json': JSON.stringify({ imports: { '#/': './src/', sdk: 'npm:sdk@^2.0.0' } }) });
  const r = typecheckChanges(deno, base, head);
  assert.deepEqual(r.projects, [{ config: 'deno.json', files: ['src/put.ts'] }]);
  assert.deepEqual(r.added, [{ file: 'src/put.ts', line: 4, code: 'TS2783', message: "'namespace_id' is specified more than once, so this usage will be overwritten." }]);

  // deno.jsonc can have comments and trailing commas. strict off hides TS2783, and Deno's lib stands for esnext,
  // so Array.prototype.at is known.
  const loose = project({ 'deno.jsonc': '{\n  // checked by deno check\n  "compilerOptions": { "strict": false, "lib": ["deno.window"], },\n  "imports": { "#/": "./src/" },\n}\n' });
  const atHead = { 'src/put.ts': put('values.update(key, { namespace_id: ns, ...defaults })', 'export const last: string = [1].at(-1);\n') };
  const l = typecheckChanges(loose, base, atHead);
  assert.deepEqual(l.projects, [{ config: 'deno.jsonc', files: ['src/put.ts'] }]);
  assert.deepEqual(l.added, [{ file: 'src/put.ts', line: 5, code: 'TS2322', message: "Type 'number' is not assignable to type 'string'." }]);

  // A tsconfig.json at the same level comes first, and a deno.json nearer the file than a tsconfig.json wins.
  assert.deepEqual(typecheckChanges(project({ 'deno.json': '{}', 'tsconfig.json': TSCONFIG({}) }), base, head).projects.map((p) => p.config), ['tsconfig.json']);
  assert.deepEqual(typecheckChanges(project({ 'tsconfig.json': TSCONFIG({}), 'src/deno.json': '{}' }), base, head).projects.map((p) => p.config), ['src/deno.json']);
});

test('watch mode passes --typecheck, so a rewrite that adds a type error opens no pull request', async () => {
  const fault = [['values\\.update\\(ns, key, JSON\\.stringify\\(data\\)\\)', 'values.update(key, { namespace_id: ns, ...JSON.stringify(data) })']];
  const run = async (typecheck) => {
    const { dir, rules, installCmd } = consumer({ 'src/kv.ts': KV, '.gitignore': 'node_modules/\n.apimigrate/\n' }, fault);
    const remote = mkdtempSync(join(tmpdir(), 'remote-'));
    git(remote, 'init', '-q', '--bare');
    git(dir, 'init', '-q');
    git(dir, 'checkout', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'base');
    git(dir, 'remote', 'add', 'origin', remote);
    const planPath = join(dirname(rules), 'plan.json');
    const entry = { name: 'sdk', package: 'sdk', line: '1', from: '1.0.0', to: '2.0.0', manifests: [], source: 'draft', signed: false, rules, ruleCount: 2, likely: 2, needsReview: 0, upstream: { from: { repo: 'github.com/acme/sdk', ref: 'v1.0.0', dir: '' }, to: { repo: 'github.com/acme/sdk', ref: 'v2.0.0', dir: '' } } };
    writeFileSync(planPath, JSON.stringify({ schema: 'apimigrate-watch/1', upgrades: [entry], skipped: [] }));
    const calls = [];
    const log = [];
    const code = await openWatchPullRequests({ root: dir, planPath, install: installCmd, typecheck, gh: (args) => calls.push(args), out: (x) => log.push(x), err: (x) => log.push(x) });
    return { code, calls, log: log.join('\n') };
  };
  const checked = await run(true);
  assert.equal(checked.code, 1, checked.log);
  assert.match(checked.log, /gate: src\/kv\.ts:4: type error added: TS2698[\s\S]*apply exited with 1, no pull request opened/);
  assert.equal(checked.calls.length, 0);
  const unchecked = await run(false);
  assert.equal(unchecked.code, 0, unchecked.log);
  assert.equal(unchecked.calls.length, 1, 'without the type-check the faulty rewrite passes the gate');
  assert.match(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'), /if \[ "\$INSTALL_CMD" != "none" \] && \[ "\$TYPECHECK" != "false" \]; then args\+=\(--typecheck\); fi/);
});

test('errors are compared by hunk on changed lines and by mapped line elsewhere', () => {
  assert.deepEqual(lineHunks('a\nb\nc\nd\ne', 'a\nB1\nB2\nB3\nc\ne'), [{ oldStart: 2, oldEnd: 3, newStart: 2, newEnd: 5 }, { oldStart: 4, oldEnd: 5, newStart: 6, newEnd: 6 }]);
  assert.deepEqual(lineHunks('a\nb', 'a\nb'), []);
  const e = (line, code, message = code, end = line) => ({ line, end, code, message });
  // Line 2 became lines 2 to 4, so the old line 5 is now line 7.
  const before = 'a\ncall(x, y)\nc\nd\nbad\n';
  const after = 'a\ncall({\n  x,\n  y })\nc\nd\nbad\n';
  const r = compareErrors(before, after, [[e(2, 'TS2554'), e(2, 'TS2345', 'kept'), e(5, 'TS2322')]], [e(3, 'TS2345', 'kept'), e(4, 'TS2783'), e(7, 'TS2322'), e(6, 'TS2322')]);
  assert.deepEqual(r.changed, [{ line: 4, code: 'TS2783', message: 'TS2783' }], 'the fixed TS2554 and the kept TS2345 do not count, the new TS2783 does');
  assert.deepEqual(r.other, [{ line: 6, code: 'TS2322', message: 'TS2322' }], 'the error that moved from line 5 to 7 is the same error');
  // An error whose span starts before the hunk still belongs to it, and the same code with another message is new.
  const span = compareErrors('f(\n  a)\n', 'f(\n  { a })\n', [[e(1, 'TS2345', 'string', 2)]], [e(1, 'TS2345', 'object', 2)]);
  assert.deepEqual(span.changed, [{ line: 1, code: 'TS2345', message: 'object' }]);
  // An error the original text had in another run, such as with the old versions, does not count. One that the
  // rewritten text has twice counts once, when each run of the original has it once.
  const twice = compareErrors('f(a)\n', 'g(a)\n', [[e(1, 'TS2554')], [e(1, 'TS2353', 'body'), e(1, 'TS2554')]], [e(1, 'TS2353', 'body'), e(1, 'TS2353', 'body')]);
  assert.deepEqual(twice.changed, [{ line: 1, code: 'TS2353', message: 'body' }]);
});

test('typecheckChanges checks only changed code files and uses defaults when no config covers them', () => {
  const dir = tree({ ...prefixed('node_modules/sdk', sdkFiles(2)), 'a.ts': "import { values } from 'sdk';\nvalues.update('k', { namespace_id: 'n', value: 'v' });\n", 'b.ts': 'export const b = 1;\n' });
  const base = { 'a.ts': "import { values } from 'sdk';\nvalues.update('k', 'v');\n", 'b.ts': 'export const b = 1;\n', 'package.json': '{}' };
  const head = { ...base, 'a.ts': readFileSync(join(dir, 'a.ts'), 'utf8'), 'package.json': '{"x":1}' };
  const r = typecheckChanges(dir, base, head);
  assert.deepEqual(r.projects, [{ config: null, files: ['a.ts'] }]);
  assert.deepEqual([r.added, r.otherLines], [[], []]);
  // A changed file of one config imported by a changed file of another has its original text in the original run.
  const mono = tree({ 'packages/a/tsconfig.json': TSCONFIG({ strict: true }).replace('"src"', '"."'), 'packages/b/tsconfig.json': TSCONFIG({ strict: true }).replace('"src"', '"."'), 'packages/a/lib.ts': 'export const n: number = 1;\n', 'packages/b/use.ts': "import { n } from '../a/lib';\nexport const s: string = n; // checked\n" });
  const monoBase = { 'packages/a/lib.ts': "export const n: string = 'x';\n", 'packages/b/use.ts': "import { n } from '../a/lib';\nexport const s: string = n;\n" };
  const monoHead = Object.fromEntries(Object.keys(monoBase).map((f) => [f, readFileSync(join(mono, f), 'utf8')]));
  const m = typecheckChanges(mono, monoBase, monoHead);
  assert.deepEqual(m.projects.map((p) => p.config), ['packages/a/tsconfig.json', 'packages/b/tsconfig.json']);
  assert.deepEqual(m.added, [{ file: 'packages/b/use.ts', line: 2, code: 'TS2322', message: "Type 'number' is not assignable to type 'string'." }]);
  // TypeScript names some files by absolute path. The result holds repository paths only.
  writeFileSync(join(dir, 'empty.ts'), '');
  const moved = typecheckChanges(dir, base, { ...head, 'a.ts': `import { e } from './empty';\n${head['a.ts']}` });
  assert.deepEqual(moved.added, [{ file: 'a.ts', line: 1, code: 'TS2306', message: "File 'empty.ts' is not a module." }]);
});
