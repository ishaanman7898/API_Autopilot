import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuleSet } from '../src/rule.js';
import { applyRuleSet } from '../src/engine.js';
import { parseArgs } from '../src/args.js';
import { parseConfig, withDefaults } from '../src/config.js';
import { unifiedDiff } from '../src/diffview.js';
import { UsageError } from '../src/errors.js';
import { ruleSet } from './fixtures/match-cases.js';

test('validation catches bad rules', () => {
  const good = ruleSet([{ id: 'm', kind: 'rename-method', match: { call: 'a.b' }, transform: { to: 'c.d' } }]);
  assert.deepEqual(validateRuleSet(good), []);
  assert.ok(validateRuleSet({ ...good, rules: [{ ...good.rules[0], kind: 'nope' }] }).length > 0);
  assert.ok(validateRuleSet({ ...good, rules: [good.rules[0], good.rules[0]] }).some((e) => /duplicate/.test(e)));
  assert.ok(validateRuleSet({ ...good, sunset: 'someday' }).length > 0);
  assert.ok(validateRuleSet({ ...good, scope: 'everything' }).length > 0);
  assert.ok(validateRuleSet(null).length > 0);
});

test('scope any: replace rules migrate named files and nothing else', () => {
  const rs = {
    schema: 'apimigrate/1', provider: 'webpack', scope: 'any', id: 'cfg-v4-to-v5', from: '4', to: '5', sunset: '2099-01-01',
    rules: [{ id: 'opt', kind: 'replace', match: { pattern: 'node: \\{ fs: "empty" \\}', files: ['webpack.config.js'] }, transform: { to: 'resolve: { fallback: { fs: false } }' } }],
  };
  assert.deepEqual(validateRuleSet(rs), []);
  const r = applyRuleSet(rs, { 'webpack.config.js': 'module.exports = { node: { fs: "empty" } };', 'other.js': 'node: { fs: "empty" }' });
  assert.match(r.files['webpack.config.js'], /resolve: \{ fallback/);
  assert.equal(r.files['other.js'], 'node: { fs: "empty" }');
  assert.deepEqual(r.changes.map((c) => c.proven), [false]);
  const noFiles = { ...rs, rules: [{ ...rs.rules[0], match: { pattern: 'x' } }] };
  assert.ok(validateRuleSet(noFiles).some((e) => /match\.files/.test(e)));
  assert.ok(validateRuleSet({ ...rs, rules: [{ ...rs.rules[0], match: { pattern: '(', files: ['a'] } }] }).length > 0);
});

test('config parsing and validation', () => {
  const cfg = parseConfig('providers: [acme, stripe]\npaths:\n  - src\n  - lib # code\nmodel: claude-sonnet-5-5\ncoverageTolerance: 0.5\n');
  assert.deepEqual(cfg.providers, ['acme', 'stripe']);
  assert.deepEqual(cfg.paths, ['src', 'lib']);
  assert.equal(withDefaults(cfg).coverageTolerance, 0.5);
  const zeros = '0'.repeat(64);
  assert.deepEqual(withDefaults(parseConfig(`pins:\n  - ${zeros}\n`)).pins, [zeros]);
  assert.deepEqual(withDefaults(parseConfig(`pins: [${zeros}]\n`)).pins, [zeros]);
  assert.throws(() => withDefaults(parseConfig('pin: [x]')), /unknown setting "pin"/);
  assert.throws(() => withDefaults(parseConfig('paths: src')), /list of strings/);
  assert.throws(() => withDefaults(parseConfig('draft: false')), /always drafts/);
  assert.throws(() => withDefaults(parseConfig('coverageTolerance: -1')), UsageError);
  assert.throws(() => parseConfig('not yaml at all'), /cannot parse/);
  assert.deepEqual(parseConfig('paths:\r\n  - src\r\n').paths, ['src']);
});

test('config list items may sit at the same indent as their key', () => {
  const cfg = withDefaults(parseConfig('paths:\n- src\n- test # tests\nproviders: [acme]\n'));
  assert.deepEqual(cfg.paths, ['src', 'test']);
  assert.deepEqual(cfg.providers, ['acme']);
  assert.throws(() => parseConfig('- src\n'), /cannot parse "- src"/, 'a bullet with no list key is still an error');
  assert.throws(() => parseConfig('draft: true\n- src\n'), /cannot parse "- src"/, 'a bullet after a scalar is still an error');
});

test('argument parsing is strict', () => {
  const spec = { bool: ['dry-run'], value: ['root'], positional: 1 };
  assert.deepEqual(parseArgs(['a', '--root', 'x', '--dry-run'], spec), { flags: { root: 'x', 'dry-run': true }, pos: ['a'] });
  assert.deepEqual(parseArgs(['--root=x', 'a'], spec).flags, { root: 'x' });
  assert.throws(() => parseArgs(['a', '--root'], spec), /needs a value/);
  assert.throws(() => parseArgs(['a', '--root', '--dry-run'], spec), /needs a value/);
  assert.throws(() => parseArgs(['a', '--dry-run=1'], spec), /does not take a value/);
  assert.throws(() => parseArgs(['a', '--other'], spec), /unknown option/);
  assert.throws(() => parseArgs([], spec), /expected 1 argument/);
  assert.throws(() => parseArgs(['a', 'b'], spec), /expected 1 argument/);
});

test('unified diffs show only changed hunks', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const b = a.replace('line 10', 'changed');
  const d = unifiedDiff('f.ts', a, b);
  assert.match(d, /^--- a\/f\.ts\n\+\+\+ b\/f\.ts\n@@ /);
  assert.match(d, /-line 10\n\+changed/);
  assert.doesNotMatch(d, /line 3\n/);
  assert.equal(unifiedDiff('f.ts', a, a).split('\n').filter((l) => l.startsWith('@@')).length, 0);
});

test('rename-dependency renames the dependency and sets its range in every package.json, keeping formatting', () => {
  const rule = { id: 'dep', kind: 'rename-dependency', match: { dependency: 'acme-sdk' }, transform: { to: '@acme/sdk', version: '^2.0.0' } };
  const rootPkg = '{\n  "name": "app",\n  "dependencies": {\n    "acme-sdk": "^1.4.0",\n    "zod": "3.0.0"\n  },\n  "scripts": { "test": "node --test" }\n}\n';
  const webPkg = '{"devDependencies":{"acme-sdk":"1.0.0"},"peerDependencies":{"acme-sdk":"*"}}';
  const files = {
    'package.json': rootPkg,
    'packages/web/package.json': webPkg,
    'packages/other/package.json': '{ "dependencies": { "zod": "3.0.0" } }\n',
    'packages/both/package.json': '{ "dependencies": { "acme-sdk": "1.0.0", "@acme/sdk": "2.0.0" } }\n',
    'packages/broken/package.json': '{ "dependencies": { "acme-sdk": "1.0.0", } oops',
    'src/a.ts': "import Acme from 'acme-sdk';\n",
    'notes/package.json.md': '"acme-sdk"',
  };
  const r = applyRuleSet(ruleSet([rule]), files);
  assert.equal(r.files['package.json'], rootPkg.replace('"acme-sdk": "^1.4.0"', '"@acme/sdk": "^2.0.0"'));
  assert.equal(r.files['packages/web/package.json'], '{"devDependencies":{"@acme/sdk":"^2.0.0"},"peerDependencies":{"@acme/sdk":"^2.0.0"}}');
  for (const f of ['packages/other/package.json', 'packages/both/package.json', 'packages/broken/package.json', 'src/a.ts', 'notes/package.json.md']) assert.equal(r.files[f], files[f], f);
  assert.deepEqual(r.changes.map((c) => [c.file, c.line, c.proven]), [['package.json', 4, true], ['packages/web/package.json', 1, true]]);
  assert.deepEqual(r.unresolved.map((u) => [u.file, u.reason]), [
    ['packages/both/package.json', 'dependencies already lists @acme/sdk'],
    ['packages/broken/package.json', 'package.json is not valid JSON'],
  ]);

  const bump = applyRuleSet(ruleSet([{ id: 'v', kind: 'rename-dependency', match: { dependency: 'zod' }, transform: { version: '^4.0.0' } }]), files);
  assert.match(bump.files['package.json'], /"zod": "\^4\.0\.0"/);
  assert.match(bump.files['packages/other/package.json'], /"zod": "\^4\.0\.0"/);

  assert.ok(validateRuleSet(ruleSet([{ id: 'x', kind: 'rename-dependency', match: { dependency: 'a' }, transform: {} }])).some((e) => /needs match\.dependency/.test(e)));
  assert.deepEqual(validateRuleSet(ruleSet([rule])), []);
});

test('reusing the program between rules gives the same result as rebuilding it for every rule', () => {
  const files = {
    'lib/client.ts': "import Acme from 'acme-sdk';\nlet cached: Acme | null = null;\nexport function getClient() {\n  if (!cached) cached = new Acme();\n  return cached;\n}\n",
    'src/a.ts': "import { getClient } from '../lib/client';\nimport type { Job } from 'acme-sdk/jobs';\ngetClient().charges.create({ amount_cents: 1 });\ngetClient().charges.capture('x');\n",
    'src/b.js': "const { getClient } = require('../lib/client');\nmodule.exports = () => getClient().charges.create({ amount_cents: 2 });\n",
    'package.json': '{ "dependencies": { "acme-sdk": "1.0.0" } }\n',
  };
  const rules = [
    { id: 'noop-1', kind: 'manual', match: { call: 'refunds.list' }, fallback: { prompt: 'p' } },
    { id: 'imp', kind: 'rename-import', match: { module: 'acme-sdk' }, transform: { to: '@acme/sdk' } },
    { id: 'noop-2', kind: 'rename-method', match: { call: 'refunds.create' }, transform: { to: 'refunds.make' } },
    { id: 'm', kind: 'rename-method', match: { call: 'charges.create' }, transform: { to: 'payments.create' } },
    { id: 'dep', kind: 'rename-dependency', match: { dependency: 'acme-sdk' }, transform: { to: '@acme/sdk', version: '^2.0.0' } },
    { id: 'p', kind: 'rename-param', match: { call: 'payments.create', param: 'amount_cents' }, transform: { to: 'amount' } },
    { id: 'cap', kind: 'manual', match: { call: 'charges.capture' }, fallback: { prompt: 'p' } },
  ];
  const cached = applyRuleSet(ruleSet(rules), files);
  const fresh = applyRuleSet(ruleSet(rules), files, {}, { reuseProgram: false });
  assert.deepEqual(cached, fresh);
  assert.match(cached.files['src/a.ts'], /getClient\(\)\.payments\.create\(\{ amount: 1 \}\)/);
  assert.match(cached.files['src/b.js'], /getClient\(\)\.payments\.create\(\{ amount: 2 \}\)/);
  assert.deepEqual(cached.unresolved.map((u) => [u.file, u.line, u.ruleId]), [['src/a.ts', 4, 'cap']]);
});
